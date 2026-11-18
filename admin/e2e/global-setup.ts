import { deployAll } from './deploy';
import { BOX, RPC } from '../playwright.config';

export default async function globalSetup() {
  const { box } = await deployAll(RPC);
  if (box.toLowerCase() !== BOX.toLowerCase()) throw new Error(`Unexpected VeGoc address ${box}`);
}
