import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Voice Lab · A space to talk",
  description:
    "A local voice conversation experiment with ChatGPT and browser-side Kokoro.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" style={{ colorScheme: "only light" }}>
      <head>
        <meta name="color-scheme" content="only light" />
      </head>
      <body>{children}</body>
    </html>
  );
}
