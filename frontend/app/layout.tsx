import type { Metadata } from "next";
import { HomeScreenTransitionProvider } from "@/components/home-screen-transition";
import "./globals.css";

export const metadata: Metadata = {
  title: "Monet",
  description: "The realtime canvas where sketch and talk become software.",
  icons: {
    icon: "/icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <head>
        <link
          rel="preload"
          href="/LastoriaBoldRegular.otf"
          as="font"
          type="font/otf"
          crossOrigin="anonymous"
        />
      </head>
      <body className="flex min-h-full flex-col bg-gray-100 text-gray-900 antialiased">
        <HomeScreenTransitionProvider>{children}</HomeScreenTransitionProvider>
      </body>
    </html>
  );
}
