import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

// 清理升级前在根作用域注册的旧版 PWA worker；旧版现在只在 /legacy/ 下运行。
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      if (new URL(registration.scope).pathname === '/') registration.unregister()
    }
  })
}

createApp(App).mount('#app')
