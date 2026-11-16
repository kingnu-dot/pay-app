import { render } from "preact";
import { App } from "./app";
import "./ui/style.css";

const root = document.getElementById("app");
if (root) render(<App />, root);

// オフラインでも開けるよう、本番のビルドでだけ Service Worker を登録する
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  });
}
