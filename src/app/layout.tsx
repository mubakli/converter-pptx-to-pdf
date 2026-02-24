import { TRPCProvider } from "../components/Provider";
import "./globals.css";

export const metadata = {
  title: "PPTX to PDF Converter",
  description: "Web interface for batch converting PPTX documents to PDF",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr">
      <body className="bg-slate-900 text-slate-100 min-h-screen font-sans selection:bg-indigo-500/30">
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
