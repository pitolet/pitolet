import type { ButtonHTMLAttributes } from 'react';
import './IconButton.css';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name (also used for the tooltip by callers). */
  label: string;
  size?: 'sm' | 'md';
  active?: boolean;
}

export function IconButton({
  label,
  size = 'md',
  active = false,
  className = '',
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      className={`ptl-icon-button ptl-icon-button--${size} ${active ? 'ptl-icon-button--active' : ''} ${className}`}
      {...props}
    />
  );
}
