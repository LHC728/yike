import { useCallback, useEffect, useRef } from 'react'

/** 同账号也可能已换了界面；旧异步回调只能关闭发起它的那次组件挂载。 */
export function useIsMounted(): () => boolean {
  const mounted = useRef(true)
  useEffect(() => {
    // StrictMode 会先清理再重新挂载 effect，不能让第一次清理永久标成失效。
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  return useCallback(() => mounted.current, [])
}
