import { z } from 'zod';
import { isoWeekRange, getIsoWeek } from './local-week.js';
import { validCalendarDate } from './calendar-date.js';
export const FacetsSchema = z
  .object({
    from: z.string().refine(validCalendarDate, 'Invalid calendar date').optional(),
    to: z.string().refine(validCalendarDate, 'Invalid calendar date').optional(),
    week: z
      .string()
      .regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/)
      .refine((value) => {
        const [year, week] = value.split('-W').map(Number);
        const actual = getIsoWeek(isoWeekRange(year!, week!).start);
        return actual.year === year && actual.week === week;
      }, 'Invalid calendar week')
      .optional(),
    speakerId: z.string().min(1).max(100).optional(),
    status: z.enum(['pending', 'processing', 'awaiting_user', 'done', 'failed']).optional(),
    actions: z.enum(['open', 'mine']).optional(),
    source: z.enum(['capture', 'import']).optional(),
    warning: z.boolean().optional(),
    content: z.enum(['summary', 'transcript']).optional(),
  })
  .strict()
  .refine(
    (value) => !value.from || !value.to || value.from <= value.to,
    'From date must not follow Through date',
  );
