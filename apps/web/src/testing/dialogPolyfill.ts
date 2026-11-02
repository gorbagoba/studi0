/**
 * jsdom (as of v30) implements <dialog>'s open property but not showModal()/
 * close(). Install once per test file that renders a dialog component.
 */
export function installDialogPolyfill(): void {
  if (typeof HTMLDialogElement === 'undefined') return;
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    close?: () => void;
  };
  if (proto.showModal === undefined) {
    proto.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    };
  }
  if (proto.close === undefined) {
    proto.close = function close(this: HTMLDialogElement): void {
      if (this.hasAttribute('open')) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      }
    };
  }
}
