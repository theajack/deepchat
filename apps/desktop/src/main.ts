import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import { useLocaleStore } from './stores/locale'

const pinia = createPinia()
createApp(App).use(pinia).mount('#app')

// 尽早设置 <html lang>，避免首屏语言闪变
useLocaleStore(pinia).init()
