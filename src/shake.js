// Schüttel-Erkennung über den Beschleunigungssensor.
// iOS verlangt eine ausdrückliche Erlaubnis, die nur aus einem Klick heraus
// angefragt werden darf – deshalb wird enableShake() von den Start-Buttons aufgerufen.

let enabled = false;
let handler = null;

export function setShakeHandler(fn) {
  handler = fn;
}

export async function enableShake() {
  if (enabled) return true;
  if (typeof DeviceMotionEvent === 'undefined') return false;
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return false;
    } catch {
      return false;
    }
  }
  let last = null;
  let peaks = [];
  let lastShake = 0;
  window.addEventListener('devicemotion', (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    if (last) {
      const delta = Math.abs(a.x - last.x) + Math.abs(a.y - last.y) + Math.abs(a.z - last.z);
      const now = performance.now();
      if (delta > 16) {
        peaks.push(now);
        peaks = peaks.filter((t) => now - t < 700);
        // Mehrere kräftige Ausschläge kurz hintereinander = Schütteln (nicht bloß Anstoßen).
        if (peaks.length >= 3 && now - lastShake > 1200) {
          lastShake = now;
          peaks = [];
          handler?.();
        }
      }
    }
    last = { x: a.x, y: a.y, z: a.z };
  });
  enabled = true;
  return true;
}
