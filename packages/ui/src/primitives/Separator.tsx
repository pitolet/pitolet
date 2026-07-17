import './Separator.css';

export function Separator({
  orientation = 'horizontal',
}: {
  orientation?: 'horizontal' | 'vertical';
}) {
  return <div role="separator" className={`ptl-separator ptl-separator--${orientation}`} />;
}
