% Static method: declared in a `methods (Static)` block, no receiver
% param. Two call syntaxes work:
%   - ClassName.method(args)  — function-call-like, no instance needed
%   - obj.staticMethod(args)  — instance-style; resolver's
%     stripInstance flag drops the receiver before specialization
classdef MathUtil
  methods (Static)
    function r = add(a, b)
      r = a + b;
    end
    function r = scale(x, k)
      r = x * k;
    end
  end
end

% ClassName.method(args)
disp(MathUtil.add(3, 4));
disp(MathUtil.scale(2.5, 10));
