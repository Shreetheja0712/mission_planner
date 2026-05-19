export function createSocketBridge() {
  const listeners = {};
  const pending = [];
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const backendHost = ['3000', '5173', '4173'].includes(window.location.port)
    ? `${window.location.hostname}:5000`
    : window.location.host;
  const ws = new WebSocket(`${protocol}//${backendHost}/ws`);

  function fire(event, data) {
    (listeners[event] || []).forEach((callback) => callback(data));
  }

  function send(event, data) {
    const payload = JSON.stringify({ command: event, payload: data || {} });
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    else pending.push(payload);
  }

  ws.addEventListener('open', () => {
    while (pending.length) ws.send(pending.shift());
    fire('connect');
  });
  ws.addEventListener('close', () => fire('disconnect'));
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    fire(message.type, message.data);
  });

  return {
    on(event, callback) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(callback);
    },
    emit: send
  };
}
