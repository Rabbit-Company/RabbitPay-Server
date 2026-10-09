declare const highlighter: {
	getLanguage(name: string): unknown;
	highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
};
export default highlighter;
