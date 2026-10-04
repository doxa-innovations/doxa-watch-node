// `next` is an optional peer dependency and is not installed in this repository: the two modules the browser entry
// imports are declared here with just what it uses.
declare module 'next/navigation.js' {
  export function usePathname(): string | null
  export function useParams(): Record<string, string | string[] | undefined> | null
}

declare module 'next/web-vitals.js' {
  export function useReportWebVitals(
    report: (metric: { name: string; value: number; rating?: string; navigationType?: string }) => void,
  ): void
}
