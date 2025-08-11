import { answerFaq } from './rag';

const q =
  process.argv.slice(2).join(' ') || 'What are your contact center hours?';
answerFaq(q).then((r) => console.log(JSON.stringify(r, null, 2)));
