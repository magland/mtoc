function main()
  disp(42);
  disp(helper(7));
  x = 3;
  disp(sq(x));
end

function y = helper(x)
  y = x + 1;
end

function z = sq(x)
  z = x * x;
end
