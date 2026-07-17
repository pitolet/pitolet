import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NumberScrubInput } from '../src/primitives/NumberScrubInput.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

function renderInput({
  onChange,
  onCommit,
}: {
  onChange: (value: number, opts: { transient: boolean }) => void;
  onCommit: () => void;
}): HTMLInputElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      createElement(NumberScrubInput, {
        value: 12,
        onChange,
        onCommit,
        label: 'W',
      }),
    );
  });
  return host.querySelector('input')!;
}

function pointerEvent(type: string, pointerId: number, clientX: number): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

describe('NumberScrubInput text editing', () => {
  it('discards a typed draft when Escape blurs the field', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const input = renderInput({ onChange, onCommit });

    act(() => input.focus());
    act(() => {
      input.value = '42';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(input.value).toBe('12');
  });

  it('commits a typed draft when Enter blurs the field', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const input = renderInput({ onChange, onCommit });

    act(() => input.focus());
    act(() => {
      input.value = '42';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));

    expect(onChange).toHaveBeenCalledWith(42, { transient: false });
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('nudges a typed zero instead of falling back to the previous value', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const input = renderInput({ onChange, onCommit });

    act(() => input.focus());
    act(() => {
      input.value = '0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));

    expect(onChange).toHaveBeenLastCalledWith(1, { transient: false });
    expect(input.value).toBe('1');
  });
});

describe('NumberScrubInput scrubbing', () => {
  it('coalesces pointer movement and flushes the final value before commit', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const input = renderInput({ onChange, onCommit });
    const label = input.parentElement!.querySelector('.ptl-scrub-label') as HTMLElement;
    let captured: number | null = null;
    label.setPointerCapture = (pointerId) => {
      captured = pointerId;
    };
    label.hasPointerCapture = (pointerId) => captured === pointerId;
    label.releasePointerCapture = () => {
      captured = null;
    };

    act(() => label.dispatchEvent(pointerEvent('pointerdown', 7, 100)));
    act(() => {
      label.dispatchEvent(pointerEvent('pointermove', 7, 101));
      label.dispatchEvent(pointerEvent('pointermove', 7, 104));
      label.dispatchEvent(pointerEvent('pointermove', 7, 109));
    });

    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(32));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(21, { transient: true });

    act(() => {
      label.dispatchEvent(pointerEvent('pointermove', 7, 115));
      label.dispatchEvent(pointerEvent('pointermove', 7, 118));
      label.dispatchEvent(pointerEvent('pointerup', 7, 118));
    });

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(30, { transient: true });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onChange.mock.invocationCallOrder.at(-1)).toBeLessThan(
      onCommit.mock.invocationCallOrder[0]!,
    );
  });
});
