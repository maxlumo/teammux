// The install banner publishes the space it takes (board #387): the reserve
// appears when the banner shows and goes when it is dismissed. jsdom has no
// layout, so the measured value is stubbed; what this proves is the lifetime.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./InstallPrompt.svelte', import.meta.url), []);

test('the banner reserves its height while it shows and releases it when it goes (#387)', async (context) => {
  const app = await (await compiled).mount(context, {
    props: {},
    modules: [],
    setup(window) {
      window.localStorage.setItem('tmux_locale', 'en');
      Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get() { return (this as HTMLElement).classList.contains('install-banner') ? 75 : 0; },
      });
      const computed = window.getComputedStyle.bind(window);
      window.getComputedStyle = (element: Element) => {
        const style = computed(element);
        return element.classList.contains('install-banner')
          ? new Proxy(style, { get: (target, key) => key === 'bottom' ? '12px' : Reflect.get(target, key) })
          : style;
      };
    },
  });
  const reserve = () => app.document.documentElement.style.getPropertyValue('--install-reserve');
  try {
    await app.flush();
    assert.equal(app.document.querySelector('.install-banner'), null);
    assert.equal(reserve(), '', 'no banner, no reserve');
    const offer = new app.window.Event('beforeinstallprompt', { cancelable: true });
    Object.assign(offer, { prompt: () => Promise.resolve(), userChoice: Promise.resolve({}) });
    app.window.dispatchEvent(offer);
    await app.flush();
    assert.ok(app.document.querySelector('.install-banner'), 'the offer shows the banner');
    assert.equal(reserve(), '87px', 'its height plus its distance from the bottom edge, read from the box');
    app.document.querySelector<HTMLButtonElement>('.install-dismiss')!.click();
    await app.flush();
    assert.equal(app.document.querySelector('.install-banner'), null);
    assert.equal(reserve(), '', 'dismissed: the page gets its space back');
  } finally { await app.close(); }
});
