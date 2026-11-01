const mockApi = {
  name: "mock-api",
  configureServer(server) {
    let users = [{ id: 1, name: "Bahaa" }];
    server.middlewares.use("/api/users", (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          try {
            const body = JSON.parse(raw);
            if (!body.name) {
              res.statusCode = 422;
              res.end(
                JSON.stringify({
                  message: "Invalid",
                  errors: { name: ["Required"] },
                }),
              );
              return;
            }
            const user = { id: users.length + 1, name: body.name };
            users.push(user);
            res.end(JSON.stringify({ data: user }));
          } catch {
            res.statusCode = 400;
            res.end("{}");
          }
        });
      } else res.end(JSON.stringify({ data: users }));
    });
  },
};
export default {
  resolve: { dedupe: ["react", "react-dom", "@tanstack/react-query"] },
  plugins: [mockApi],
  esbuild: { jsx: "automatic" },
};
