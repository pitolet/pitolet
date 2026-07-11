export function Landing() {
  return (
    <div className="flex flex-col items-stretch font-sans text-foreground bg-background">
      <nav className="flex items-center justify-between py-4 px-12">
        <span className="text-lg font-[650] tracking-[-0.3px]">northwind</span>
        <div className="flex items-center gap-y-2 gap-x-6">
          <a className="text-sm text-muted-foreground">Product</a>
          <a className="text-sm text-muted-foreground">Pricing</a>
          <a className="text-sm text-muted-foreground">Changelog</a>
        </div>
      </nav>
      <section className="flex flex-col items-center gap-6 py-24 px-12">
        <h1 className="max-w-[720px] text-6xl font-bold tracking-[-1.5px] text-center">Design and code, one artifact.</h1>
        <p className="max-w-[560px] text-xl leading-normal text-center text-muted-foreground">
          Northwind turns your design system into production interfaces, so the mockup and the shipped build stay in sync.
        </p>
        <div className="flex gap-3 pt-2">
          <button className="py-3 px-6 text-base font-[550] text-primary-foreground bg-primary rounded-md cursor-pointer">Get started</button>
          <button className="py-3 px-6 text-base font-[550] text-foreground border border-border rounded-md cursor-pointer">View docs</button>
        </div>
      </section>
      <section className="flex gap-6 pb-16 px-12">
        <article className="flex flex-col gap-2 p-6 flex-1 min-w-0 bg-muted rounded-lg">
          <h3 className="text-lg font-semibold">Design in the browser</h3>
          <p className="text-sm leading-[1.6] text-muted-foreground">Every element is real CSS, so what you see is what ships.</p>
        </article>
        <article className="flex flex-col gap-2 p-6 flex-1 min-w-0 bg-muted rounded-lg">
          <h3 className="text-lg font-semibold">Tokens first</h3>
          <p className="text-sm leading-[1.6] text-muted-foreground">
            Colors, spacing and type scale live in one place and flow everywhere.
          </p>
        </article>
        <article className="flex flex-col gap-2 p-6 flex-1 min-w-0 bg-muted rounded-lg">
          <h3 className="text-lg font-semibold">Agent native</h3>
          <p className="text-sm leading-[1.6] text-muted-foreground">
            Your coding agent reads and edits designs right on the canvas.
          </p>
        </article>
      </section>
    </div>
  );
}
