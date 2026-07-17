import './Kbd.css';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

/** Renders a shortcut like "mod+shift+k" as platform-appropriate key caps. */
export function Kbd({ keys }: { keys: string }) {
  const parts = keys.split('+').map(displayKey);
  return (
    <kbd className="ptl-kbd">
      {parts.map((p, i) => (
        <span key={i} className="ptl-kbd-key">
          {p}
        </span>
      ))}
    </kbd>
  );
}

function displayKey(key: string): string {
  switch (key.toLowerCase()) {
    case 'mod':
      return IS_MAC ? '⌘' : 'Ctrl';
    case 'cmd':
    case 'meta':
      return '⌘';
    case 'ctrl':
      return IS_MAC ? '⌃' : 'Ctrl';
    case 'alt':
    case 'option':
      return IS_MAC ? '⌥' : 'Alt';
    case 'shift':
      return '⇧';
    case 'enter':
      return '↵';
    case 'escape':
    case 'esc':
      return 'Esc';
    case 'backspace':
      return '⌫';
    case 'arrowup':
      return '↑';
    case 'arrowdown':
      return '↓';
    case 'arrowleft':
      return '←';
    case 'arrowright':
      return '→';
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}
