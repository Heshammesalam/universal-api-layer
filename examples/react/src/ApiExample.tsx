import { useApiQuery, useApiMutation } from "universal-api-layer/react";
export default function ApiExample() {
  const users = useApiQuery<
    { data: { id: number; name: string }[] },
    { id: number; name: string }[]
  >({
    key: ["users"],
    url: "/users",
    select: (response) => response?.data ?? [],
  });
  const create = useApiMutation({ url: "/users", invalidateKeys: [["users"]] });
  return (
    <section>
      <button onClick={() => create.mutate({ name: "Bahaa" })}>Add user</button>
      {users.isPending ? (
        <p>Loading...</p>
      ) : users.error ? (
        <p>{users.error.message}</p>
      ) : (
        <pre>{JSON.stringify(users.data)}</pre>
      )}
      {create.error && <pre>{JSON.stringify(create.error.fieldErrors)}</pre>}
    </section>
  );
}
