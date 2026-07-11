import { Tabs as BaseTabs } from '@base-ui-components/react/tabs';
import type { ReactNode } from 'react';
import './Tabs.css';

export interface TabDef {
  value: string;
  label: ReactNode;
}

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  tabs: TabDef[];
  /** Panels keyed by tab value; omit to render nothing (caller switches). */
  children?: ReactNode;
  size?: 'sm' | 'md';
}

/** Segmented-control style tabs used across panels. */
export function Tabs({ value, onValueChange, tabs, children, size = 'md' }: TabsProps) {
  return (
    <BaseTabs.Root
      value={value}
      onValueChange={(v) => onValueChange(v as string)}
      className="ptl-tabs"
    >
      <BaseTabs.List className={`ptl-tabs-list ptl-tabs-list--${size}`}>
        {tabs.map((tab) => (
          <BaseTabs.Tab key={tab.value} value={tab.value} className="ptl-tabs-tab">
            {tab.label}
          </BaseTabs.Tab>
        ))}
        <BaseTabs.Indicator className="ptl-tabs-indicator" />
      </BaseTabs.List>
      {children}
    </BaseTabs.Root>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <BaseTabs.Panel value={value} className="ptl-tabs-panel">
      {children}
    </BaseTabs.Panel>
  );
}
