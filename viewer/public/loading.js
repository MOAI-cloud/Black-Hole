// Also runs before npm, Vite or CUDA have been prepared on first launch.
class GargantuaLoader extends HTMLElement {
  static observedAttributes = ['message', 'step', 'failed'];

  connectedCallback() {
    this.innerHTML = `<div class="boot-card">
      <div class="boot-type">Black hole simulator</div>
      <div class="boot-title">Gargantua</div>
      <div class="boot-state"><i aria-hidden="true"></i><span class="boot-message" role="status"></span></div>
      <progress max="7" aria-label="Application startup"></progress>
      <button type="button" hidden>Reload viewer</button>
    </div>`;
    this.querySelector('button').onclick = () => location.reload();
    this.attributeChangedCallback();
    if (this.hasAttribute('launcher')) void this.pollLauncher();
  }

  attributeChangedCallback() {
    const progress = this.querySelector('progress');
    if (!progress) return;
    const message = this.getAttribute('message') || 'Opening the observatory…';
    const failed = this.hasAttribute('failed');
    this.querySelector('.boot-message').textContent = message;
    progress.value = Number(this.getAttribute('step') || 1);
    progress.setAttribute('aria-valuetext', message);
    progress.hidden = failed;
    this.querySelector('button').hidden = !failed || this.hasAttribute('launcher');
  }

  async pollLauncher() {
    try {
      const response = await fetch('/api/startup', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not reach the launcher.');
      const state = await response.json();
      if (state.ready) { location.replace(location.href); return; }
      this.setAttribute('message', state.message);
      this.setAttribute('step', state.step);
      if (state.failed) { this.setAttribute('failed', ''); return; }
    } catch {
      this.setAttribute('message', 'Waiting for the local launcher…');
    }
    if (this.isConnected) setTimeout(() => this.pollLauncher(), 250);
  }
}
customElements.define('gargantua-loader', GargantuaLoader);
