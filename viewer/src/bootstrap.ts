const loader = document.querySelector<HTMLElement>('gargantua-loader')!;
const app = document.getElementById('app')!;

async function boot() {
  try {
    // Allow the browser to paint the startup screen before synchronous GPU setup.
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    loader.setAttribute('message', 'Preparing light paths and orbital flow…');
    loader.setAttribute('step', '5');
    const viewer = await import('./main');
    await viewer.ready;
    app.inert = false;
    loader.remove();
  } catch (error) {
    console.error('Could not start Gargantua.', error);
    loader.setAttribute('message', 'The viewer could not start. Reload to try again.');
    loader.setAttribute('failed', '');
  }
}
void boot();
