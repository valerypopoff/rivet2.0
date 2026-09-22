import { type FC } from 'react';
import { useAtom } from 'jotai';
import { css } from '@emotion/react';
import { Field, Label } from '@atlaskit/form';
import Range from '@atlaskit/range';
import {
  DEFAULT_UI_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  UI_FONT_SIZE_STEP,
  clampUiFontSize,
} from '../../../utils/uiFontSize.js';
import {
  canvasBackgroundColorModeState,
  canvasBackgroundColorOptions,
  canvasBackgroundCustomColorState,
  canvasBackgroundPatternOpacityState,
  canvasBackgroundPatternState,
  canvasBackgroundPatterns,
  CANVAS_BACKGROUND_PATTERN_OPACITY_STEP,
  clampCanvasBackgroundPatternOpacity,
  customThemePrimaryColorState,
  customThemeSecondaryColorState,
  formatCanvasBackgroundCustomColor,
  formatCustomThemePrimaryColor,
  formatCustomThemeSecondaryColor,
  MAX_CANVAS_BACKGROUND_PATTERN_OPACITY,
  MIN_CANVAS_BACKGROUND_PATTERN_OPACITY,
  parseCanvasBackgroundCustomColor,
  parseCustomThemePrimaryColor,
  parseCustomThemeSecondaryColor,
  resolveCanvasBackgroundColorMode,
  type CanvasBackgroundPattern,
  type CanvasBackgroundColorMode,
  preservePortTextCaseState,
  resolveEditorPreferences,
  resolveCanvasBackgroundPattern,
  settingsState,
  type Theme,
  themeState,
  themes,
  zoomSensitivityState,
} from '../../../state/settings.js';
import { uiFontSizeState } from '../../../state/ui.js';
import { fields } from '../settingsPageStyles.js';
import { LabeledToggle } from '../../LabeledToggle.js';
import { FieldHelperMessage } from '../../FieldHelperMessage.js';
import { SegmentedEditor } from '../../editors/SegmentedEditor.js';
import { CompactColorPicker } from '../../CompactColorPicker.js';

const uiSettingsPageStyles = css`
  .custom-theme-color-pickers {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--settings-field-gap);
  }

  .custom-theme-color-pickers > * {
    flex: 0 1 180px;
  }
`;

export const UiSettingsPage: FC = () => {
  const [settings, setSettings] = useAtom(settingsState);
  const [theme, setTheme] = useAtom(themeState);
  const [customThemePrimaryColor, setCustomThemePrimaryColor] = useAtom(customThemePrimaryColorState);
  const [customThemeSecondaryColor, setCustomThemeSecondaryColor] = useAtom(customThemeSecondaryColorState);
  const [uiFontSize, setUiFontSize] = useAtom(uiFontSizeState);
  const [zoomSensitivity, setZoomSensitivity] = useAtom(zoomSensitivityState);
  const [preservePortTextCase, setPreservePortTextCase] = useAtom(preservePortTextCaseState);
  const [canvasBackgroundColorMode, setCanvasBackgroundColorMode] = useAtom(canvasBackgroundColorModeState);
  const [canvasBackgroundCustomColor, setCanvasBackgroundCustomColor] = useAtom(canvasBackgroundCustomColorState);
  const [canvasBackgroundPattern, setCanvasBackgroundPattern] = useAtom(canvasBackgroundPatternState);
  const [canvasBackgroundPatternOpacity, setCanvasBackgroundPatternOpacity] = useAtom(
    canvasBackgroundPatternOpacityState,
  );
  const editorPreferences = resolveEditorPreferences(settings);
  const normalizedCustomThemePrimaryColor = parseCustomThemePrimaryColor(customThemePrimaryColor);
  const normalizedCustomThemeSecondaryColor = parseCustomThemeSecondaryColor(
    customThemeSecondaryColor,
    customThemePrimaryColor,
  );
  const normalizedUiFontSize = clampUiFontSize(uiFontSize);
  const normalizedCanvasBackgroundColorMode = resolveCanvasBackgroundColorMode(canvasBackgroundColorMode);
  const normalizedCanvasBackgroundCustomColor = parseCanvasBackgroundCustomColor(canvasBackgroundCustomColor);
  const normalizedCanvasBackgroundPattern = resolveCanvasBackgroundPattern(canvasBackgroundPattern);
  const normalizedCanvasBackgroundPatternOpacity = clampCanvasBackgroundPatternOpacity(canvasBackgroundPatternOpacity);
  const capitalizeNodePortNames = !preservePortTextCase;

  return (
    <div css={[fields, uiSettingsPageStyles]}>
      <section className="settings-section" aria-labelledby="ui-settings-theme-font-size">
        <h2 id="ui-settings-theme-font-size" className="settings-section-heading">
          Theme and font size
        </h2>
        <div className="settings-section-fields">
          <SegmentedEditor
            value={theme}
            onChange={(value) => setTheme(value as Theme)}
            isReadonly={false}
            isDisabled={false}
            label="Theme"
            name="theme"
            options={themes}
          />
          {theme === 'custom' && (
            <div className="custom-theme-color-pickers">
              <Field name="customThemePrimaryColor" label="Custom primary color">
                {() => (
                  <CompactColorPicker
                    label="Choose custom primary color"
                    color={normalizedCustomThemePrimaryColor}
                    onChange={(newColor) => {
                      setCustomThemePrimaryColor(
                        formatCustomThemePrimaryColor({
                          r: newColor.rgb.r,
                          g: newColor.rgb.g,
                          b: newColor.rgb.b,
                          a: newColor.rgb.a ?? 1,
                        }),
                      );
                    }}
                  />
                )}
              </Field>
              <Field name="customThemeSecondaryColor" label="Custom secondary color">
                {() => (
                  <CompactColorPicker
                    label="Choose custom secondary color"
                    color={normalizedCustomThemeSecondaryColor}
                    onChange={(newColor) => {
                      setCustomThemeSecondaryColor(
                        formatCustomThemeSecondaryColor({
                          r: newColor.rgb.r,
                          g: newColor.rgb.g,
                          b: newColor.rgb.b,
                          a: newColor.rgb.a ?? 1,
                        }),
                      );
                    }}
                  />
                )}
              </Field>
            </div>
          )}
          <Field name="uiFontSize">
            {() => (
              <>
                <Label htmlFor="uiFontSize" testId="uiFontSize">
                  UI font size: {normalizedUiFontSize}px
                </Label>
                <FieldHelperMessage>
                  Scales Rivet UI text and icon glyphs. Code editor text uses its separate editor font-size controls.
                </FieldHelperMessage>
                <div className="toggle-field settings-range-field">
                  <Range
                    min={MIN_UI_FONT_SIZE}
                    max={MAX_UI_FONT_SIZE}
                    step={UI_FONT_SIZE_STEP}
                    value={normalizedUiFontSize}
                    onChange={(value) => {
                      if (Number.isNaN(value) || value == null) {
                        setUiFontSize(DEFAULT_UI_FONT_SIZE);
                        return;
                      }

                      setUiFontSize(clampUiFontSize(value));
                    }}
                  />
                </div>
              </>
            )}
          </Field>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="ui-settings-canvas">
        <h2 id="ui-settings-canvas" className="settings-section-heading">
          Canvas
        </h2>
        <div className="settings-section-fields">
          <SegmentedEditor
            value={normalizedCanvasBackgroundColorMode}
            onChange={(value) => setCanvasBackgroundColorMode(value as CanvasBackgroundColorMode)}
            isReadonly={false}
            isDisabled={false}
            label="Canvas color"
            name="canvas-color"
            options={canvasBackgroundColorOptions}
          />
          {normalizedCanvasBackgroundColorMode === 'custom' && (
            <Field name="canvasCustomColor" label="Custom canvas color">
              {() => (
                <CompactColorPicker
                  label="Choose custom canvas color"
                  color={normalizedCanvasBackgroundCustomColor}
                  onChange={(newColor) => {
                    setCanvasBackgroundCustomColor(
                      formatCanvasBackgroundCustomColor({
                        r: newColor.rgb.r,
                        g: newColor.rgb.g,
                        b: newColor.rgb.b,
                        a: newColor.rgb.a ?? 1,
                      }),
                    );
                  }}
                />
              )}
            </Field>
          )}
          <SegmentedEditor
            value={normalizedCanvasBackgroundPattern}
            onChange={(value) => setCanvasBackgroundPattern(value as CanvasBackgroundPattern)}
            isReadonly={false}
            isDisabled={false}
            label="Pattern type"
            name="canvas-pattern"
            options={canvasBackgroundPatterns}
          />
          <Field name="canvasPatternOpacity">
            {() => (
              <>
                <Label htmlFor="canvasPatternOpacity" testId="canvasPatternOpacity">
                  Canvas pattern opacity: {Math.round(normalizedCanvasBackgroundPatternOpacity * 1000) / 10}%
                </Label>
                <FieldHelperMessage>
                  Controls the grid, dot, or cross pattern strength independently of the theme.
                </FieldHelperMessage>
                <div className="toggle-field settings-range-field">
                  <Range
                    min={MIN_CANVAS_BACKGROUND_PATTERN_OPACITY}
                    max={MAX_CANVAS_BACKGROUND_PATTERN_OPACITY}
                    step={CANVAS_BACKGROUND_PATTERN_OPACITY_STEP}
                    value={normalizedCanvasBackgroundPatternOpacity}
                    onChange={(value) => {
                      setCanvasBackgroundPatternOpacity(clampCanvasBackgroundPatternOpacity(value));
                    }}
                  />
                </div>
              </>
            )}
          </Field>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="ui-settings-node-style-behavior">
        <h2 id="ui-settings-node-style-behavior" className="settings-section-heading">
          Nodes style and behavior
        </h2>
        <div className="settings-section-fields">
          <Field name="capitalize-node-port-names">
            {() => (
              <>
                <LabeledToggle
                  id="capitalize-node-port-names"
                  isChecked={capitalizeNodePortNames}
                  onChange={(value) => setPreservePortTextCase(!value)}
                  label="Capitalize node port names"
                  helperMessage={
                    <>
                      When enabled, node port names are shown in uppercase, e.g. `newInputPort` is shown as
                      `NEWINPUTPORT`. Disable this to preserve the original text case for each port.
                    </>
                  }
                  className="settings-toggle-field"
                />
              </>
            )}
          </Field>
          <Field name="default-node-colors">
            {() => (
              <>
                <LabeledToggle
                  id="default-node-colors"
                  isChecked={editorPreferences.applyDefaultNodeColors}
                  onChange={(value) =>
                    setSettings((state) => ({
                      ...state,
                      defaultNodeColors: value,
                    }))
                  }
                  label="Default node colors"
                  helperMessage="When enabled, some newly added nodes use default colors."
                  className="settings-toggle-field"
                />
              </>
            )}
          </Field>
          <Field name="open-node-settings-on-create">
            {() => (
              <>
                <LabeledToggle
                  id="open-node-settings-on-create"
                  isChecked={editorPreferences.openNodeSettingsOnCreate}
                  onChange={(value) =>
                    setSettings((state) => ({
                      ...state,
                      openNodeSettingsOnCreate: value,
                    }))
                  }
                  label="Open node settings on create"
                  helperMessage="When enabled, newly created nodes open their settings panel immediately."
                  className="settings-toggle-field"
                />
              </>
            )}
          </Field>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="ui-settings-misc">
        <h2 id="ui-settings-misc" className="settings-section-heading">
          Misc
        </h2>
        <div className="settings-section-fields">
          <Field name="zoomSensitivity">
            {() => (
              <>
                <Label htmlFor="zoomSensitivity" testId="zoomSensitivity">
                  Zoom sensitivity
                </Label>
                <FieldHelperMessage>
                  The sensitivity of the zoom when using the mouse wheel. Lower values will zoom slower.
                </FieldHelperMessage>
                <div className="toggle-field settings-range-field">
                  <Range
                    min={0.01}
                    max={2}
                    step={0.01}
                    value={zoomSensitivity}
                    onChange={(value) => {
                      if (Number.isNaN(value) || value == null) {
                        return;
                      }

                      setZoomSensitivity(value);
                    }}
                  />
                </div>
              </>
            )}
          </Field>
        </div>
      </section>
    </div>
  );
};
