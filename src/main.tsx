import { render } from "preact";
import { App, UPDATE_READY_EVENT } from "./app";
import "./ui/style.css";

const root = document.getElementById("app");
if (root) render(<App />, root);

// オフラインでも開けるよう、本番のビルドでだけ Service Worker を登録する
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // すでに Service Worker の管理下で開いた画面で、管理する Service Worker が入れ替わったら、
  // 新しい版が配信されたということ。開いている画面は古いままなので、再読み込みを促す
  const had_controller = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (had_controller) window.dispatchEvent(new Event(UPDATE_READY_EVENT));
  });
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  });
}
