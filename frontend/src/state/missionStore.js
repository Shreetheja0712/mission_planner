export function createMissionStore() {
  let state = {
    connected: false,
    batteryLevel: -1,
    mission: { status: 'idle' }
  };
  const listeners = new Set();

  function publish() {
    listeners.forEach(listener => listener(state));
  }

  function update(values) {
    state = { ...state, ...values };
    publish();
  }

  return {
    canResume() {
      return state.mission.status === 'paused'
        && state.batteryLevel > 20
        && state.connected;
    },

    getMission() {
      return state.mission;
    },

    isLocked() {
      return state.mission.status === 'running'
        || state.mission.status === 'paused';
    },

    setBatteryLevel(batteryLevel) {
      update({ batteryLevel });
    },

    setConnected(connected) {
      update({ connected });
    },

    setMission(mission) {
      update({ mission });
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    }
  };
}
