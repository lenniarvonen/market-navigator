import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Market Navigator",
  description: "A sourced map of your market: peers, capital share, moat and likely acquirers, built on Cala.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
