// Verbindung zum Relay-Server. Der Server kennt keine Spielregeln: Er merkt sich pro Raum
// den letzten Spielstand und reicht neue Stände an alle anderen im Raum weiter.

export function wsUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export class Net {
  /**
   * @param {{room:string, pid:string, create:boolean, getState:()=>object|null, on:(msg:object)=>void, onStatus:(up:boolean)=>void}} o
   */
  constructor(o) {
    Object.assign(this, o);
    this.ws = null;
    this.closed = false;
    this.tries = 0;
    this.joined = false;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const ws = (this.ws = new WebSocket(wsUrl()));
    ws.onopen = () => {
      this.tries = 0;
      // Beim Wiederverbinden den eigenen Stand mitschicken: Falls der Server neu
      // gestartet wurde und den Raum vergessen hat, lebt das Spiel damit weiter.
      this.send({
        t: 'join',
        room: this.room,
        pid: this.pid,
        create: this.create && !this.joined,
        resume: this.joined ? this.getState() : null,
      });
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'joined') {
        this.joined = true;
        this.onStatus(true);
      }
      this.on(m);
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.onStatus(false);
      setTimeout(() => this.connect(), Math.min(5000, 400 * 2 ** this.tries++));
    };
    ws.onerror = () => ws.close();
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
