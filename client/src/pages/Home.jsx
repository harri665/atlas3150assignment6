import { PrismBackdrop, PrismHero } from '../Components/Homepage/Prism'

// the portfolio's CS homepage (cs.harrison-martin.com) without its project gallery
export default function Home() {
  return (
    <div className="relative min-h-screen bg-bg text-ink">
      <PrismBackdrop lens="cs" tone="page" />
      <PrismHero
        fullHeight
        align="left"
        glassTitle
        glassSubtitle
        title="Relight"
        subtitle={
          <>
            The CSS glass and the relight engine on this page are copied from my portfolio website,{' '}
            <a
              href="https://cs.harrison-martin.com"
              className="underline decoration-line/25 underline-offset-4"
            >
              cs.harrison-martin.com
            </a>
            .
          </>
        }
      />
    </div>
  )
}
