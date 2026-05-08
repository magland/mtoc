disp(safe_div(10, 2));
disp(safe_div(10, 0));
disp(first_positive(-3, -1, 5, 7));

function y = safe_div(a, b)
  y = 0;
  if b == 0
    return;
  end
  y = a / b;
end

function out = first_positive(a, b, c, d)
  out = a;
  if a > 0
    return;
  end
  out = b;
  if b > 0
    return;
  end
  out = c;
  if c > 0
    return;
  end
  out = d;
end
