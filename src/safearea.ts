export const computeSafeArea = (area?: { x: number; y: number; width: number; height: number }) => {
  return area ?? { x: 0, y: 0, width: 100, height: 100 };
};
