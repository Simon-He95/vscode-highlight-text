export function isReg(o: any): o is RegExp {
  return typeof o === 'object' && o.constructor === RegExp
}
