disp(square_then_double(3));
disp(square_then_double(-4));
disp(rms3(3, 4, 12));

function y = sq(x)
  y = x * x;
end

function y = double_it(x)
  y = 2 * x;
end

function y = square_then_double(x)
  y = double_it(sq(x));
end

function y = rms3(a, b, c)
  y = sqrt((sq(a) + sq(b) + sq(c)) / 3);
end
