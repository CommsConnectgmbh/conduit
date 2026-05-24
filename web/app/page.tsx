import { redirect } from "next/navigation";
import { getSessionFromCookies } from "@/lib/auth";
import { Chat } from "@/components/Chat";

export const dynamic = "force-dynamic";

export default async function Home() {
  const sess = await getSessionFromCookies();
  if (!sess) redirect("/login");
  return <Chat email={sess.email} />;
}
