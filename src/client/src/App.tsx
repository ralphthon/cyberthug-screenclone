function App(): JSX.Element {
  return (
    <main className="min-h-screen bg-surface text-slate-100">
      <section className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-6">
        <div className="text-center">
          <h1 className="bg-gradient-to-r from-primary via-indigo-400 to-violet-300 bg-clip-text text-6xl font-bold tracking-tight text-transparent">
            RalphTon
          </h1>
          <p className="mt-4 text-lg text-slate-400">
            Drop a screenshot. Watch it clone.
          </p>
        </div>
      </section>
    </main>
  );
}

export default App;
