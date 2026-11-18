import { setActivePlugins } from "../plugins/index.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ApiError, setCsrfToken } from "../api.ts";
import { PRODUCT_NAME } from "../product.ts";
import { Icon } from "./Icon.tsx";

const POINTS = [
  "Lo que hagas aquí se ve también en Outlook, y al revés.",
  "Los correos se conservan aunque se vacíe el buzón.",
  "Todo se guarda en el servidor de tu oficina.",
];

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "El correo o la contraseña no son correctos.";
    if (error.status === 429) {
      return "Demasiados intentos seguidos. Espera 15 minutos y vuelve a probar.";
    }
    return error.message;
  }
  return "No se ha podido entrar. Inténtalo de nuevo.";
}

export function Login() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: (session) => {
      setCsrfToken(session.csrfToken);
      setActivePlugins(session.plugins);
      queryClient.setQueryData(["session"], session);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!login.isPending) login.mutate();
  };

  return (
    <div className="flex h-full min-h-[600px] bg-ground">
      <div className="hidden w-[520px] shrink-0 flex-col gap-6 bg-rail px-14 pt-14 pb-12 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-[7px] bg-accent">
            <Icon name="mail" />
          </span>
          <span className="text-[15px] font-semibold">{PRODUCT_NAME}</span>
        </div>
        <div className="grow" />
        <h1 className="m-0 text-[30px] leading-[1.2] font-semibold tracking-[-0.02em]">
          El correo de siempre, con todo el histórico a mano.
        </h1>
        <ul className="m-0 flex list-none flex-col gap-3 p-0 text-sm leading-normal text-line">
          {POINTS.map((point) => (
            <li key={point} className="flex gap-2.5">
              <Icon name="check" className="mt-[3px] text-[#8FB4F2]" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex grow items-center justify-center p-6">
        <form onSubmit={submit} className="flex w-full max-w-[360px] flex-col gap-[18px]">
          <div className="flex flex-col gap-1.5">
            <h2 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">Entrar</h2>
            <p className="m-0 text-ink-2">
              Usa el correo y la contraseña que te dio tu administrador.
            </p>
          </div>

          {login.isError && (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-warn-line bg-warn px-3 py-2.5 leading-[1.45] text-warn-ink"
            >
              <Icon name="alert" className="mt-px" />
              <span>{errorText(login.error)}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="correo" className="font-semibold">
              Correo
            </label>
            <input
              id="correo"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-11 rounded-md border border-[#8C97A6] bg-white px-3 text-sm text-ink"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="clave" className="font-semibold">
              Contraseña
            </label>
            <input
              id="clave"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-11 rounded-md border border-[#8C97A6] bg-white px-3 text-sm text-ink"
            />
          </div>
          <button
            type="submit"
            disabled={login.isPending}
            className="h-11 rounded-md border-0 bg-accent text-sm font-semibold text-white disabled:opacity-70"
          >
            {login.isPending ? "Entrando…" : "Entrar"}
          </button>
          <p className="m-0 text-xs leading-normal text-ink-2">
            ¿No recuerdas la contraseña? Pídele a tu administrador que te ponga una nueva.
          </p>
        </form>
      </div>
    </div>
  );
}
