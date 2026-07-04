export const renderVideo = async (inputPath?: string): Promise<string> => {
  // Minimal stub: pretend rendering succeeded and return output path
  return inputPath ? `${inputPath}_rendered.mp4` : 'rendered.mp4';
};
