import type { Request, Response, NextFunction } from 'express';

type AsyncFunction<T extends Request> = (
  req: T,
  res: Response,
  next: NextFunction
) => Promise<any>;

type AsyncHandler<T extends Request> = (
  req: T,
  res: Response,
  next: NextFunction
) => void;

const asyncHandler = <T extends Request>(
  execution: AsyncFunction<T>
): AsyncHandler<T> => {
  return (req: T, res: Response, next: NextFunction): void => {
    execution(req, res, next).catch(next);
  };
};

export default asyncHandler;
