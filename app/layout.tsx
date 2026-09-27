import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'pixels — a life sim',
  description: '600 pixels with hormones, genes and inherited brains',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
