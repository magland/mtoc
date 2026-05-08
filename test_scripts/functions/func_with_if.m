disp(clamp(5, 0, 10));
disp(clamp(-3, 0, 10));
disp(clamp(15, 0, 10));
disp(abs2(-7));
disp(abs2(7));

function y = clamp(x, lo, hi)
  if x < lo
    y = lo;
  elseif x > hi
    y = hi;
  else
    y = x;
  end
end

function y = abs2(x)
  if x < 0
    y = -x;
  else
    y = x;
  end
end
