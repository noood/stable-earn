import { NextResponse } from "next/server";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";

export function GET() {
  return NextResponse.json({ error: "退出登录方式已更新，请返回私人页刷新后，再使用菜单中的“退出登录”。" }, {
    status: 405,
    headers: { ...privateResponseHeaders, Allow: "POST" },
  });
}

export function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });
  }

  const response = NextResponse.redirect(new URL("/", request.url), 303);
  response.cookies.set({
    name: "CF_Authorization",
    value: "",
    expires: new Date(0),
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
