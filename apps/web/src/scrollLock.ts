let lockCount = 0;
let restoreScroll: (() => void) | undefined;

export function lockPageScroll(): () => void {
  if (lockCount === 0) {
    const { body, documentElement } = document;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const bodyStyles = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    const overflow = documentElement.style.overflow;
    Object.assign(body.style, {
      position: 'fixed',
      top: `-${scrollY}px`,
      left: `-${scrollX}px`,
      width: '100%',
      overflow: 'hidden',
    });
    documentElement.style.overflow = 'hidden';
    restoreScroll = () => {
      Object.assign(body.style, bodyStyles);
      documentElement.style.overflow = overflow;
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
    };
  }

  // Overlapping dialogs can unmount in either order. Only the last one unlocks the page.
  lockCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lockCount === 0) {
      restoreScroll?.();
      restoreScroll = undefined;
    }
  };
}
