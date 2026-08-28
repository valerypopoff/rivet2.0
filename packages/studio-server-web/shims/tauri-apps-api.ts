// Shim for @tauri-apps/api
// getCurrent() throws to make isInTauri() return false

export const window = {
  getCurrent() {
    throw new Error('Not running in Tauri');
  },
};

export const event = {
  listen: async () => () => {},
  emit: async () => {},
};
