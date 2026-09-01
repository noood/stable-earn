import { redirect } from "next/navigation";

export default function PrivateIndexPage() {
  redirect("/private/home");
}
