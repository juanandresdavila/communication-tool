import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `dist` es la salida del build del paquete cliente: linteála y vas a
  // reportar errores sobre código generado que nadie edita.
  { ignores: ['node_modules/**', '.vercel/**', 'coverage/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
