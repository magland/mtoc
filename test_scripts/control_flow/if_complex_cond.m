% Cross-runner coverage for complex `if` / `elseif` conditions.
% numbl's toBool on complex: `creal(z) != 0 || cimag(z) != 0`.

% Pure-real nonzero.
if 1 + 0i
  disp(11);
else
  disp(10);
end

% Pure-imag nonzero.
if 0 + 2i
  disp(21);
else
  disp(20);
end

% Both zero — falsy.
if 0 + 0i
  disp(31);
else
  disp(30);
end

% Mixed nonzero.
if 3 - 4i
  disp(41);
end

% Through a variable. Real lane is NaN; `NaN != 0` is true in IEEE 754
% so the cond is truthy.
z = (0/0) + 0i;
if z
  disp(51);
else
  disp(50);
end

% elseif chain mixing complex and real conds.
w = 0 + 0i;
if w
  disp(61);
elseif 1 + 2i
  disp(62);
else
  disp(60);
end
