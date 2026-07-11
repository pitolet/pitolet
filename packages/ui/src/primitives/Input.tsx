import type { InputHTMLAttributes, ReactNode } from 'react';
import './Input.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  /** Small leading adornment, e.g. an icon or unit label. */
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export function Input({ prefix, suffix, className = '', ...props }: InputProps) {
  return (
    <span className={`ptl-input-wrap ${className}`}>
      {prefix != null && <span className="ptl-input-affix">{prefix}</span>}
      <input className="ptl-input" {...props} />
      {suffix != null && <span className="ptl-input-affix">{suffix}</span>}
    </span>
  );
}
