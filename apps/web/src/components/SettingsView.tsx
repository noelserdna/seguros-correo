import { plugins } from "../plugins/index.ts";

/** Pantalla de Configuración. Cada plugin aporta su apartado. */
export function SettingsView({ isAdmin }: { isAdmin: boolean }) {
  const sections = plugins.filter((plugin) => plugin.SettingsSection);
  return (
    <main className="min-w-0 grow overflow-y-auto bg-panel">
      <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-6">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">Configuración</h1>
          {!isAdmin && (
            <p className="m-0 text-xs text-ink-2">
              Puedes consultar estos ajustes. Para cambiarlos hace falta un administrador.
            </p>
          )}
        </div>
        {sections.map(
          (plugin) =>
            plugin.SettingsSection && <plugin.SettingsSection key={plugin.id} isAdmin={isAdmin} />,
        )}
        {sections.length === 0 && (
          <p className="m-0 text-ink-2">Todavía no hay nada que configurar.</p>
        )}
      </div>
    </main>
  );
}
