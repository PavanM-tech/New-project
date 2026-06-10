import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Ved',
  description: 'Voice-first camera help for calculations and visual questions.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
