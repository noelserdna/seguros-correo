import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api.ts";
import { App } from "./App.tsx";
import "./styles.css";

// Si la sesión caduca, cualquier petición devuelve 401: se vuelve a la pantalla de acceso.
const onError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401) {
    queryClient.setQueryData(["session"], null);
  }
};

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (failures, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
