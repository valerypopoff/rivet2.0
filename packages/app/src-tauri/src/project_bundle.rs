use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleFile {
    pub path: String,
    pub contents: String,
    pub source_project_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectBundle {
    pub manifest_path: String,
    pub manifest_contents: String,
    pub selected_project_path: Option<String>,
    pub files: Vec<BundleFile>,
}

fn read_bounded(path: &Path, limit: u64) -> Result<String, String> {
    let file = File::open(path).map_err(|_| "Could not open bundle file.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Could not inspect bundle file.")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("Bundle file exceeds its size limit or is not a regular file.".into());
    }
    let mut data = Vec::with_capacity(metadata.len() as usize + 1);
    file.take(metadata.len() + 1)
        .read_to_end(&mut data)
        .map_err(|_| "Could not read bundle file.")?;
    if data.len() as u64 != metadata.len() {
        return Err("Bundle file changed size during loading. Retry opening it.".into());
    }
    String::from_utf8(data).map_err(|_| "Bundle file is not valid UTF-8.".into())
}

/** Discovery is deliberately limited to the manifest itself or its standard projects folder. */
pub fn read_bundle(selected: &Path) -> Result<Option<NativeProjectBundle>, String> {
    let selected = selected
        .canonicalize()
        .map_err(|_| "Could not resolve selected project path.")?;
    let direct = selected
        .file_name()
        .map_or(false, |name| name == "rivet-bundle.json");
    let manifest = if direct {
        selected.clone()
    } else {
        let parent = match selected.parent() {
            Some(parent) if parent.file_name().map_or(false, |name| name == "projects") => parent,
            _ => return Ok(None),
        };
        let manifest = parent
            .parent()
            .ok_or("Invalid bundle directory.")?
            .join("rivet-bundle.json");
        match fs::metadata(&manifest) {
            Ok(_) => manifest,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Could not inspect bundle manifest.".into()),
        }
    };
    let root = manifest
        .parent()
        .ok_or("Invalid bundle directory.")?
        .canonicalize()
        .map_err(|_| "Could not resolve bundle directory.")?;
    let manifest = manifest
        .canonicalize()
        .map_err(|_| "Could not resolve bundle manifest.")?;
    if !manifest.starts_with(&root) {
        return Err("Bundle manifest escapes its directory.".into());
    }
    let contents = read_bounded(&manifest, 1024 * 1024)?;
    // Windows text editors may prefix UTF-8 with a BOM. Match Node's UTF-8
    // decoder without relaxing malformed UTF-8 or JSON validation.
    let json = contents.strip_prefix('\u{feff}').unwrap_or(&contents);
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "Invalid bundle manifest JSON.")?;
    if value["format"] != "rivet-project-bundle" {
        return Err("Not a Rivet project bundle.".into());
    }
    let artifacts = value["artifacts"]
        .as_array()
        .ok_or("Invalid bundle artifact list.")?;
    if artifacts.is_empty() || artifacts.len() > 256 {
        return Err("Invalid or oversized bundle artifact list.".into());
    }
    let mut files = Vec::new();
    let mut total = 0u64;
    let mut selected_is_project = direct;
    for artifact in artifacts {
        for key in ["project", "datasets"] {
            if key == "datasets" && artifact.get(key).is_none() {
                continue;
            }
            let relative = artifact[key]["path"]
                .as_str()
                .ok_or("Invalid bundle artifact path.")?;
            let path = PathBuf::from(relative);
            if relative.is_empty()
                || relative.contains('\\')
                || relative.contains(':')
                || relative.contains('\0')
                || relative
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
                || path
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
            {
                return Err("Unsafe bundle artifact path.".into());
            }
            let path = root
                .join(path)
                .canonicalize()
                .map_err(|_| format!("Missing bundle file: {}", relative))?;
            if !path.starts_with(&root) {
                return Err("Bundle file escapes its directory.".into());
            }
            if key == "project" && path == selected {
                selected_is_project = true;
            }
            let data = read_bounded(&path, (64 * 1024 * 1024).min(512 * 1024 * 1024 - total))?;
            total += data.len() as u64;
            files.push(BundleFile {
                path: relative.into(),
                contents: data,
                source_project_path: path.to_string_lossy().into(),
            });
        }
    }
    if !selected_is_project {
        return Err("The selected project is not listed in rivet-bundle.json.".into());
    }
    Ok(Some(NativeProjectBundle {
        manifest_path: manifest.to_string_lossy().into(),
        manifest_contents: json.into(),
        selected_project_path: if direct {
            None
        } else {
            Some(selected.to_string_lossy().into())
        },
        files,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "rivet-native-bundle-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(root.join("projects")).unwrap();
            fs::write(root.join("projects/root.rivet-project"), "editable root").unwrap();
            let fixture = Self(root);
            fixture.manifest("projects/root.rivet-project");
            fixture
        }
        fn manifest(&self, path: &str) {
            fs::write(
                self.0.join("rivet-bundle.json"),
                json!({"format":"rivet-project-bundle", "artifacts":[{"project":{"path":path}}]})
                    .to_string(),
            )
            .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn project_bundle_reads_manifest_and_declared_member_only() {
        let f = Fixture::new();
        let direct = read_bundle(&f.0.join("rivet-bundle.json"))
            .unwrap()
            .unwrap();
        assert!(direct.selected_project_path.is_none());
        assert_eq!(direct.files[0].contents, "editable root");
        let member = read_bundle(&f.0.join("projects/root.rivet-project"))
            .unwrap()
            .unwrap();
        assert_eq!(
            member.selected_project_path.unwrap(),
            member.files[0].source_project_path
        );
        fs::write(f.0.join("projects/unlisted.rivet-project"), "unlisted").unwrap();
        assert!(read_bundle(&f.0.join("projects/unlisted.rivet-project"))
            .err()
            .unwrap()
            .contains("not listed"));
        fs::write(f.0.join("standalone.rivet-project"), "standalone").unwrap();
        assert!(read_bundle(&f.0.join("standalone.rivet-project"))
            .unwrap()
            .is_none());
        fs::remove_file(f.0.join("rivet-bundle.json")).unwrap();
        assert!(read_bundle(&f.0.join("projects/root.rivet-project"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn project_bundle_rejects_unsafe_missing_and_oversized_files() {
        let f = Fixture::new();
        for path in [
            "../escape",
            "/absolute",
            "C:/absolute",
            "projects\\root",
            "projects//root",
            "projects/./root",
        ] {
            f.manifest(path);
            assert!(
                read_bundle(&f.0.join("rivet-bundle.json"))
                    .err()
                    .unwrap()
                    .contains("Unsafe"),
                "{}",
                path
            );
        }
        f.manifest("projects/missing.rivet-project");
        assert!(read_bundle(&f.0.join("rivet-bundle.json"))
            .err()
            .unwrap()
            .contains("Missing"));
        f.manifest("projects/root.rivet-project");
        File::options()
            .write(true)
            .open(f.0.join("projects/root.rivet-project"))
            .unwrap()
            .set_len(64 * 1024 * 1024 + 1)
            .unwrap();
        assert!(read_bundle(&f.0.join("rivet-bundle.json"))
            .err()
            .unwrap()
            .contains("size limit"));
    }

    #[test]
    fn project_bundle_accepts_utf8_bom_but_rejects_invalid_utf8() {
        let f = Fixture::new();
        let manifest = f.0.join("rivet-bundle.json");
        let json = fs::read_to_string(&manifest).unwrap();
        fs::write(&manifest, format!("\u{feff}{}", json)).unwrap();
        let bundle = read_bundle(&manifest).unwrap().unwrap();
        assert_eq!(bundle.manifest_contents, json);
        fs::write(&manifest, [0xff, 0xfe]).unwrap();
        assert!(read_bundle(&manifest).err().unwrap().contains("UTF-8"));
    }

    #[test]
    fn project_bundle_does_not_hide_a_malformed_sibling_manifest() {
        let f = Fixture::new();
        fs::write(f.0.join("rivet-bundle.json"), "broken").unwrap();
        assert!(read_bundle(&f.0.join("projects/root.rivet-project"))
            .err()
            .unwrap()
            .contains("JSON"));
    }
}
